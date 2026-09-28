using System;

class Program
{
    static void Main()
    {
        int number = int.Parse(Console.ReadLine());
        if (number != 0)
        {
            Console.WriteLine("Число задано");
        }
        else
        {
            Console.WriteLine("Ноль");
        }
    }
}