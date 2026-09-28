using System;

class Program
{
    static void Main()
    {
        int number = int.Parse(Console.ReadLine());
        
        if (number == 0)
        {
            Console.WriteLine("Ноль");
        }
        else if (number > 0)
        {
            if (number % 2 == 0)
            {
                Console.WriteLine("Положительное чётное");
            }
            else
            {
                Console.WriteLine("Положительное нечётное");
            }
        }
        else
        {
            if (number % 2 == 0)
            {
                Console.WriteLine("Отрицательное чётное");
            }
            else
            {
                Console.WriteLine("Отрицательное нечётное");
            }
        }
    }
}