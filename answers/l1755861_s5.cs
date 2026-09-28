using System;

class Program
{
    static void Main()
    {
        double a = double.Parse(Console.ReadLine());
        double b = double.Parse(Console.ReadLine());
        string op = Console.ReadLine();
        
        if (op == "+")
        {
            Console.WriteLine(a + b);
        }
        else if (op == "-")
        {
            Console.WriteLine(a - b);
        }
        else if (op == "*")
        {
            Console.WriteLine(a * b);
        }
        else if (op == "/")
        {
            if (b == 0)
            {
                Console.WriteLine("Ошибка: деление на ноль");
            }
            else
            {
                Console.WriteLine(a / b);
            }
        }
        else
        {
            Console.WriteLine("Неизвестная операция");
        }
    }
}