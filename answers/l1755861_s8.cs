using System;

class Program
{
    static void Main()
    {
        string input = Console.ReadLine();
        char ch = input[0];
        
        if (ch >= '0' && ch <= '9')
        {
            Console.WriteLine("Цифра");
        }
        else if (ch >= 'A' && ch <= 'Z')
        {
            Console.WriteLine("Заглавная латинская буква");
        }
        else if (ch >= 'a' && ch <= 'z')
        {
            Console.WriteLine("Строчная латинская буква");
        }
        else
        {
            Console.WriteLine("Специальный символ");
        }
    }
}